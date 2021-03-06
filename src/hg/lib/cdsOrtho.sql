# cdsOrtho.sql was originally generated by the autoSql program, which also 
# generated cdsOrtho.c and cdsOrtho.h.  This creates the database representation of
# an object which can be loaded and saved from RAM in a fairly 
# automatic way.

#Information about a CDS region in another species, created by looking at multiple alignment.
CREATE TABLE cdsOrtho (
    name varchar(255) not null,	# Name of transcript
    start int not null,	# CDS start within transcript
    end int not null,	# CDS end within transcript
    species varchar(255) not null,	# Other species (or species database)
    missing int not null,	# Number of bases missing (non-aligning)
    orthoSize int not null,	# Size of orf in other species
    possibleSize int not null,	# Possible size of orf in other species
    ratio double not null,	# orthoSize/possibleSize
              #Indices
    PRIMARY KEY(name)
);
